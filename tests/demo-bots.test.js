import { describe, expect, it } from "vitest";
import { isAllowedRequest, resolveDemoTarget } from "../demo-bots/target.mjs";
import { FUNCTIONS, PERSONAS, lintKit, parseRunArgs, uncovered } from "../demo-bots/run.mjs";
import { SCRIPTS, copy } from "../demo-bots/scripts.mjs";
import { STAFF_PLANES } from "../src/components/planes.js";

describe("demo bot target guard", () => {
  it("accepts only a loopback app and points at the demo entry", () => {
    expect(resolveDemoTarget("http://127.0.0.1:4173")).toEqual({ origin: "http://127.0.0.1:4173", host: "127.0.0.1:4173", demoUrl: "http://127.0.0.1:4173/m?demo=1" });
    expect(resolveDemoTarget("http://localhost:5173/anything").origin).toBe("http://localhost:5173");
    expect(resolveDemoTarget("http://[::1]:5173").host).toBe("[::1]:5173");
    // A default port is spelled out, so the proxy bypass never covers a whole host.
    expect(resolveDemoTarget("http://localhost").host).toBe("localhost:80");
    expect(resolveDemoTarget("https://localhost").host).toBe("localhost:443");
  });

  it("refuses hosted, credentialed, non-http and malformed targets", () => {
    // A hosted deployment is refused even when it is Union Ground's own:
    // "Exit demo" there would land a bot on a real sign-in screen.
    expect(() => resolveDemoTarget("https://unionground.example")).toThrow(/loopback/);
    expect(() => resolveDemoTarget("http://10.0.0.5:5173")).toThrow(/loopback/);
    expect(() => resolveDemoTarget("http://127.0.0.1.example.com")).toThrow(/loopback/);
    expect(() => resolveDemoTarget("http://bot:secret@127.0.0.1:5173")).toThrow(/credentials/);
    expect(() => resolveDemoTarget("file:///tmp/index.html")).toThrow(/scheme/);
    expect(() => resolveDemoTarget("")).toThrow(/absolute/);
  });

  it("lets a demo page reach only its own origin", () => {
    const origin = "http://127.0.0.1:4173";
    expect(isAllowedRequest("http://127.0.0.1:4173/assets/app.js", origin)).toBe(true);
    expect(isAllowedRequest("data:image/png;base64,AAAA", origin)).toBe(true);
    expect(isAllowedRequest("http://127.0.0.1:54321/rest/v1/members", origin)).toBe(false);
    expect(isAllowedRequest("https://example.supabase.co/auth/v1/token", origin)).toBe(false);
    expect(isAllowedRequest("not a url", origin)).toBe(false);
  });
});

describe("demo bot kit", () => {
  it("is internally consistent and covers every catalog function", () => {
    expect(lintKit()).toEqual([]);
    expect(uncovered()).toEqual([]);
    expect(FUNCTIONS.length).toBeGreaterThan(0);
  });

  it("reports a script that names an unknown bot or function", () => {
    const broken = [{ id: "W-X", bot: "bot-99", covers: ["DM-999"], run() {} }];
    expect(lintKit({ scripts: broken })).toEqual(expect.arrayContaining([
      "W-X: unknown bot bot-99",
      "W-X: covers unknown function DM-999",
    ]));
  });

  it("reports a script that cannot run", () => {
    const { run: _run, ...stripped } = SCRIPTS[0];
    expect(lintKit({ scripts: [stripped, ...SCRIPTS.slice(1)] })).toEqual([`${stripped.id}: no run function`]);
  });

  it("refuses a run that would select nothing or misread a flag", () => {
    expect(parseRunArgs(["run"]).scripts).toBe(SCRIPTS);
    expect(parseRunArgs(["run", "--only", "W-CHAIR-01, W-MEMBER-01,W-CHAIR-01"]).scripts.map((script) => script.id)).toEqual(["W-MEMBER-01", "W-CHAIR-01"]);
    expect(() => parseRunArgs(["run", "--only", ","])).toThrow(/at least one script id/);
    expect(() => parseRunArgs(["run", "--only", "W-NOPE-01"])).toThrow(/Unknown script in --only: W-NOPE-01/);
    expect(() => parseRunArgs(["run", "--only"])).toThrow(/--only needs a value/);
    expect(() => parseRunArgs(["run", "--base-url", "--headed"])).toThrow(/--base-url needs a value/);
    expect(() => parseRunArgs(["run", "--out"])).toThrow(/--out needs a value/);
  });

  it("gives every persona a seat the demo actually has", () => {
    const seats = new Set(["member", "prospect", ...STAFF_PLANES.map((plane) => plane.key)]);
    for (const persona of PERSONAS) expect(seats.has(persona.hat), persona.id).toBe(true);
    // Every staff hat is driven by at least one script.
    const drivenHats = new Set(SCRIPTS.map((script) => PERSONAS.find((persona) => persona.id === script.bot).hat));
    for (const plane of STAFF_PLANES) expect(drivenHats.has(plane.key), plane.key).toBe(true);
  });

  it("keeps persona contact details off any deliverable domain", () => {
    expect(JSON.stringify(PERSONAS)).not.toMatch(/@|https?:\/\//);
  });

  it("reads checks from the app's own copy", () => {
    expect("Exit demo").toMatch(copy("demo.exit"));
    expect("Salir de la demo").toMatch(copy("demo.exit", "es"));
    expect(() => copy("demo.noSuchKey")).toThrow(/No app copy/);
  });
});
