import { describe, expect, it, vi } from "vitest";
import { BrowserClient, defaultStackParser } from "@sentry/browser";
import { createStackParser } from "@sentry/core";
import { ServerRuntimeClient, nodeStackLineParser } from "@sentry/core/server";
import { privateSentryOptions, privateSentryTransport, sanitizeSentryEnvelope, sanitizeSentryEvent } from "../src/lib/sentryPrivacy.js";

const PRIVATE_TEXT = "Taylor Example says the disciplinary grievance contains medical details";
const MEMBER_ID = "c14abe37-740b-44c3-b4ac-5e77e5bcf966";
const memberEvent = () => ({
  event_id: "1234567890abcdef1234567890abcdef",
  level: "error",
  user: { id: MEMBER_ID, email: "member@example.invalid", username: "Taylor Example", ip_address: "192.0.2.42" },
  request: { url: `https://unionground.invalid/m/members/${MEMBER_ID}?q=${PRIVATE_TEXT}#secret`,
    headers: { Authorization: "Bearer fake-private-token", Cookie: "session=fake-private-cookie" },
    cookies: { session: "fake-private-cookie" }, data: { fullName: "Taylor Example", body: PRIVATE_TEXT } },
  message: PRIVATE_TEXT, logentry: { formatted: PRIVATE_TEXT, params: [MEMBER_ID] },
  extra: { arbitrary: PRIVATE_TEXT, nested: { memberId: MEMBER_ID }, safe_looking: "Taylor Example" },
  contexts: { arbitrary: { value: PRIVATE_TEXT }, device: { name: "Taylor Example's phone", id: MEMBER_ID } },
  tags: { innocent: MEMBER_ID }, transaction: PRIVATE_TEXT, fingerprint: [MEMBER_ID],
  breadcrumbs: [{ category: "navigation", message: PRIVATE_TEXT, data: { to: MEMBER_ID } }],
  exception: { values: [{ type: PRIVATE_TEXT, value: PRIVATE_TEXT, mechanism: { data: { person: MEMBER_ID } },
    stacktrace: { frames: [{ filename: `/members/${MEMBER_ID}`, function: PRIVATE_TEXT,
      lineno: 42, colno: 7, in_app: true, vars: { person: MEMBER_ID }, pre_context: [PRIVATE_TEXT],
      context_line: PRIVATE_TEXT, post_context: [PRIVATE_TEXT] }] } }] },
  threads: { values: [{ name: PRIVATE_TEXT }] }, spans: [{ description: PRIVATE_TEXT }],
  debug_meta: { images: [{ code_file: PRIVATE_TEXT }] }, modules: { [PRIVATE_TEXT]: MEMBER_ID },
  sdk: { name: PRIVATE_TEXT }, future_sdk_field: { anything: PRIVATE_TEXT },
});

function assertNoMemberData(value) {
  const text = JSON.stringify(value);
  for (const privateValue of [PRIVATE_TEXT, MEMBER_ID, "Taylor Example", "member@example.invalid", "192.0.2.42", "fake-private-token", "fake-private-cookie", "medical"])
    expect(text).not.toContain(privateValue);
}

describe("Sentry member-data boundary", () => {
  it("drops identities and arbitrary content wherever the SDK can carry them, without changing the source", () => {
    const event = memberEvent();
    const original = structuredClone(event);
    const clean = sanitizeSentryEvent(event);
    expect(event).toEqual(original);
    assertNoMemberData(clean);
    expect(clean.exception.values[0].stacktrace.frames[0]).toEqual({ filename: "app:///application", lineno: 42, colno: 7, in_app: true });
    for (const key of ["user", "request", "extra", "contexts", "tags", "breadcrumbs", "logentry", "fingerprint", "transaction", "threads", "spans", "debug_meta", "modules", "future_sdk_field"])
      expect(clean).not.toHaveProperty(key);
  });

  it("fails closed on malformed values, unknown telemetry types and throwing getters", () => {
    for (const value of [null, [], "private", { type: "transaction" }, { type: "feedback" }, { get level() { throw new Error(PRIVATE_TEXT); } }])
      expect(sanitizeSentryEvent(value)).toBeNull();
    expect(sanitizeSentryEvent({ message: PRIVATE_TEXT, event_id: MEMBER_ID, platform: PRIVATE_TEXT })).toEqual({ level: "error", message: "Application error" });
  });

  it("removes sensitive item headers, sampling context and all non-error envelope items", () => {
    const envelope = [{ trace: { user_id: MEMBER_ID }, arbitrary: PRIVATE_TEXT, sent_at: PRIVATE_TEXT, dsn: `https://${MEMBER_ID}@example.invalid/1` }, [
      [{ type: "event", filename: PRIVATE_TEXT }, memberEvent()],
      ...["attachment", "session", "sessions", "transaction", "span", "replay_event", "replay_recording", "profile", "profile_chunk", "log", "logs", "trace_metric", "feedback", "check_in", "client_report"].map(type => [{ type }, { value: PRIVATE_TEXT }]),
    ]];
    const clean = sanitizeSentryEnvelope(envelope, { surface: "web", environment: "preview", release: "a".repeat(40) });
    assertNoMemberData(clean);
    // Relay replaces the event ID with the header's, so the header carries it.
    expect(clean[0]).toEqual({ event_id: "1234567890abcdef1234567890abcdef", sdk: { name: "sentry.javascript.unionground-private-errors", version: "1.0.0", settings: { infer_ip: "never" } } });
    expect(clean[1]).toHaveLength(1);
    expect(clean[1][0][0]).toEqual({ type: "event" });
    expect(clean[1][0][1]).toMatchObject({ tags: { surface: "web" }, environment: "preview", release: "a".repeat(40) });
    expect(clean[1][0][1].sdk.settings.infer_ip).toBe("never");
    // A present geo stops Relay's connection-IP geo lookup; nothing else of a user is sent.
    expect(clean[1][0][1].user).toEqual({ geo: { lookup: "disabled" } });
    expect(sanitizeSentryEnvelope([{}, [[{ type: "attachment" }, PRIVATE_TEXT]]])).toBeNull();
  });

  it("keeps a well-formed DSN and send time on the envelope header and nothing else", () => {
    const dsn = `https://${"a".repeat(32)}@o0.ingest.us.sentry.io/1`;
    const sentAt = "2026-10-11T21:00:00.123Z";
    const clean = sanitizeSentryEnvelope([{ dsn, sent_at: sentAt, event_id: "f".repeat(32), sdk: { name: PRIVATE_TEXT } }, [[{ type: "event" }, { message: PRIVATE_TEXT }]]]);
    expect(Object.keys(clean[0]).sort()).toEqual(["dsn", "sdk", "sent_at"]);
    expect(clean[0]).toMatchObject({ dsn, sent_at: sentAt });
    expect(clean[0].sdk.name).toBe("sentry.javascript.unionground-private-errors");
  });

  // The server functions run @sentry/core's server client (api/_lib/observability.js).
  it.each([
    ["BrowserClient", BrowserClient, defaultStackParser],
    ["ServerRuntimeClient", ServerRuntimeClient, createStackParser(nodeStackLineParser())],
  ])("scrubs actual %s SDK output after scope processing and drops attachments before transport", async (_name, Client, stackParser) => {
    const send = vi.fn(async () => ({ statusCode: 200 }));
    const client = new Client({
      dsn: "https://public@o0.ingest.us.sentry.io/1",
      ...privateSentryOptions(),
      stackParser,
      integrations: [],
      transport: privateSentryTransport(() => ({ send, flush: async () => true }), { environment: "preview", surface: "web" }),
    });
    client.init();
    client.captureEvent(memberEvent(), { attachments: [{ filename: `${MEMBER_ID}.txt`, data: PRIVATE_TEXT }] });
    await client.flush(2000);
    expect(send).toHaveBeenCalledTimes(1);
    assertNoMemberData(send.mock.calls[0][0]);
    expect(send.mock.calls[0][0][1].map(item => item[0].type)).toEqual(["event"]);
    expect(send.mock.calls[0][0][0].event_id).toMatch(/^[a-f0-9]{32}$/);
    expect(send.mock.calls[0][0][0].event_id).toBe(send.mock.calls[0][0][1][0][1].event_id);
    expect(send.mock.calls[0][0][1][0][1].user).toEqual({ geo: { lookup: "disabled" } });
    await client.close(2000);
  });

  it("never forwards malformed or content-only envelopes and preserves flush behavior", async () => {
    const send = vi.fn();
    const flush = vi.fn(async () => true);
    const transport = privateSentryTransport(() => ({ send, flush }))({});
    for (const envelope of [null, [], [{}, []], [{}, [[{ type: "event" }, PRIVATE_TEXT]]], [{}, [[{ type: "session" }, memberEvent()]]]])
      await expect(transport.send(envelope)).resolves.toEqual({});
    expect(send).not.toHaveBeenCalled();
    await transport.flush(20);
    expect(flush).toHaveBeenCalledWith(20);
  });
});
