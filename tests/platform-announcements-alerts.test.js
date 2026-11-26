// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { postAnnouncementAlert } from "../api/_lib/announcementAlerts.js";
describe("private announcement retry alerts",()=>{
  it("uses only closed metadata and Eastern time, never supplied content",async()=>{
    const fetchImpl=vi.fn().mockResolvedValue({ok:true});
    const env={UG_ALERTS_SLACK_WEBHOOK_URL:"https://hooks.slack.com/services/test/test/test",VERCEL_ENV:"production"};
    expect(await postAnnouncementAlert("retry",{env,fetchImpl,now:new Date("2026-10-29T20:00:00-04:00")})).toBe("posted");
    const text=JSON.parse(fetchImpl.mock.calls[0][1].body).text;
    expect(text).toContain("retry");expect(text).toContain("ET");expect(text).not.toMatch(/recipientList|organizationId|Bearer|https:\/\//);
    expect(await postAnnouncementAlert("retry",{env,fetchImpl,now:new Date("2026-10-29T20:01:00-04:00")})).toBe("throttled");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("refuses an unsafe destination and allows a rejected alert to retry",async()=>{
    const fetchImpl=vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValue({ok:true});
    const now=new Date("2026-10-29T21:00:00-04:00");
    expect(await postAnnouncementAlert("failed",{env:{UG_ALERTS_SLACK_WEBHOOK_URL:"https://attacker.test"},fetchImpl,now})).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
    const env={UG_ALERTS_SLACK_WEBHOOK_URL:"https://hooks.slack.com/services/test/test/test"};
    expect(await postAnnouncementAlert("failed",{env,fetchImpl,now})).toBe("rejected");
    expect(await postAnnouncementAlert("failed",{env,fetchImpl,now})).toBe("posted");
  });
});
