// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The real isVercelCron runs: the success path sends only the documented Vercel tick.
vi.mock("../api/_lib/backend.js", async original => ({...await original(),resolveSupabaseBackend:vi.fn()}));
vi.mock("../api/_lib/announcementAlerts.js", () => ({postAnnouncementAlert:vi.fn().mockResolvedValue("posted")}));
vi.mock("../api/_lib/http.js", async original => ({...await original(),supabaseRpc:vi.fn(),validateMutationOrigin:vi.fn()}));
import handler from "../api/platform-announcements-dispatch.js";
import { resolveSupabaseBackend } from "../api/_lib/backend.js";
import { supabaseRpc, validateMutationOrigin } from "../api/_lib/http.js";
import { postAnnouncementAlert } from "../api/_lib/announcementAlerts.js";
import { unauthenticatedCronTickHeaders, vercelCronTickHeaders } from "./helpers/vercelCronTick.js";
const CRON_SECRET="platform-announcements-cron-secret";
const tick=()=>({method:"GET",headers:vercelCronTickHeaders(CRON_SECRET,"*/5 * * * *")});
const response=()=>({setHeader:vi.fn(),status:vi.fn().mockReturnThis(),json:vi.fn(),end:vi.fn()});
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("CRON_SECRET",CRON_SECRET);validateMutationOrigin.mockReturnValue(true);resolveSupabaseBackend.mockReturnValue({url:"https://backend.test",serviceRoleKey:"server-only",surface:"saas"});supabaseRpc.mockResolvedValue({state:"idle"});});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe("bounded private announcement worker",()=>{
  it("refuses a browser, forged cron and untrusted origin without contacting the database",async()=>{
    const res=response();await handler({method:"POST",headers:{}},res);
    expect(res.status).toHaveBeenCalledWith(401);expect(supabaseRpc).not.toHaveBeenCalled();
    for(const headers of [unauthenticatedCronTickHeaders("*/5 * * * *"),{...vercelCronTickHeaders("not-the-secret"),"x-vercel-cron":"1"}]){
      const refused=response();await handler({method:"GET",headers},refused);expect(refused.status).toHaveBeenCalledWith(401);
    }
    vi.stubEnv("CRON_SECRET","");const unset=response();await handler(tick(),unset);expect(unset.status).toHaveBeenCalledWith(503);
    expect(supabaseRpc).not.toHaveBeenCalled();vi.stubEnv("CRON_SECRET",CRON_SECRET);
    validateMutationOrigin.mockReturnValue(false);await handler({method:"POST",headers:{}},response());expect(supabaseRpc).not.toHaveBeenCalled();
  });
  it("accepts the documented Vercel cron tick: the bearer, no x-vercel-cron marker",async()=>{
    const res=response();await handler(tick(),res);
    expect(res.status).not.toHaveBeenCalledWith(401);expect(supabaseRpc).toHaveBeenCalledOnce();
    expect(tick().headers).not.toHaveProperty("x-vercel-cron");
  });
  it("makes exactly one bounded call using only server custody and returns no progress data",async()=>{
    const res=response();supabaseRpc.mockResolvedValue({state:"pending",scanned:100,delivered:99,recipientList:["forbidden"]});
    await handler(tick(),res);
    expect(supabaseRpc).toHaveBeenCalledExactlyOnceWith("https://backend.test","server-only","server-only","dispatch_platform_announcements",{p_batch_limit:100});
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ok:true}));expect(res.setHeader).toHaveBeenCalledWith("Cache-Control","no-store");
    expect(postAnnouncementAlert).not.toHaveBeenCalled();
  });
  it.each(["retry","failed","unavailable"])("privately alerts %s without freeform payload",async state=>{
    supabaseRpc.mockResolvedValue({state,body:"sensitive",organizationId:"private"});const res=response();await handler(tick(),res);
    expect(postAnnouncementAlert).toHaveBeenCalledExactlyOnceWith(state);expect(res.status).toHaveBeenCalledWith(502);expect(res.end).toHaveBeenCalledWith(JSON.stringify({ok:false}));
  });
  it("flattens transport errors and unknown state",async()=>{
    supabaseRpc.mockRejectedValueOnce(new Error("content and secret"));await handler(tick(),response());
    expect(postAnnouncementAlert).toHaveBeenCalledWith("unavailable");
    supabaseRpc.mockResolvedValueOnce({state:"unrecognized-content"});await handler(tick(),response());expect(postAnnouncementAlert).toHaveBeenCalledTimes(2);
  });
});
