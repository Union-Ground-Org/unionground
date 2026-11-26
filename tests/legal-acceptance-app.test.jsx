import { capturedAppClientFixture } from "./helpers/capturedAppClientFixture.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";
import { pinnedSampleSupabaseOrigin } from "../src/lib/sampleBackend.js";
import * as legalReleaseBundle from "../src/lib/legalReleaseBundle.js";
import { publishedVersionsWithProof } from "./helpers/legal-publication.js";

// The bundled legal release is published only with the deployment's proof
// (tests/helpers/legal-publication.js); this file renders acceptance against it.
let legalProofSpy;
beforeEach(() => {
  legalProofSpy = vi.spyOn(legalReleaseBundle, "loadPublishedWebVersions").mockImplementation(publishedVersionsWithProof);
});
afterEach(() => legalProofSpy?.mockRestore());


// Test-only authenticated member and material-change fixtures; no published
// version or provider state is changed to exercise the next-sign-in path.
const harness = vi.hoisted(() => {
  const user = { id: "member-1", email: "member@example.test" };
  const session = { user, access_token: "fictional-test-token" };
  const state = { versions: {}, calls: [], failWrite: false, authChanged: null, backendUrl: "" };
  const execute = async (resource) => {
    if (resource === "member_profiles") return { data: { id: user.id, first_name: "Darnell", full_name: "Darnell Foster", initials: "DF", language: "en", chapter_id: "chapter-1" }, error: null };
    return { data: [], error: null };
  };
  const client = {
    async rpc(name, args) {
      state.calls.push({ name, args });
      if (name === "get_my_legal_acceptance_state") {
        const versions = state.versions;
        if (state.holdRead) await state.holdRead;
        return { data: { versions, acceptedAt: null }, error: null };
      }
      if (name === "record_legal_acceptance") {
        if (state.failWrite === "pack") return { data: null, error: { code: "22023", message: "legal versions not current" } };
        if (state.failWrite) return { data: null, error: { message: "offline" } };
        state.versions = args.p_versions;
        return { data: { recorded: true }, error: null };
      }
      return { data: null, error: null };
    },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange(fn) { state.authChanged = fn; return { data: { subscription: { unsubscribe() {} } } }; },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
    },
    channel() { const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} }; return channel; },
    removeChannel() {}, realtime: { setAuth() {} },
  };
  client.from = (table) => {
    let query;
    query = new Proxy({}, { get(_target, key) { return key === "then" ? (resolve, reject) => execute(table).then(resolve, reject) : () => query; } });
    return query;
  };
  return { client, state, session };
});

// This edition pins no SAMPLE project, so the shipped check refuses every
// target. The SAMPLE case pins the fictional project of
// tests/helpers/b00-pinned-sample-backend.js; the check keeps the shipped rule
// (exactly the pinned project counts as SAMPLE).
vi.mock("../src/lib/sampleBackend.js", async (importOriginal) => {
  const actual = await importOriginal();
  const { SAMPLE_REF, pinnedSampleBackendModule } = await import("./helpers/b00-pinned-sample-backend.js");
  const isSampleSupabaseProject = (originOrRef) => {
    const value = String(originOrRef || "").trim().toLowerCase();
    return value === SAMPLE_REF || actual.supabaseRefFromOrigin(value) === SAMPLE_REF;
  };
  return { ...pinnedSampleBackendModule(actual), isSampleSupabaseProject };
});

// The main ("live") client in every case; only the project its URL names
// differs, through the real project check.
vi.mock("../src/lib/supabase.js", async (original) => {
  const { isSampleSupabaseProject } = await import("../src/lib/sampleBackend.js");
  return { ...await original(), appBackendKind: "live", get appBackendIsSampleProject() { return isSampleSupabaseProject(harness.state.backendUrl); }, hasAppBackend: true, appAuthStorageUnavailable: false, appSupabase: harness.client, createCapturedAppSessionRpcClient: () => capturedAppClientFixture(harness.client) };
});
vi.mock("../src/lib/legalInstruments.js", async (original) => {
  const actual = await original();
  const instruments = actual.LEGAL_INSTRUMENTS.map((entry) => entry.key === "terms-of-use"
    ? { ...entry, changelog: entry.changelog.map((change) => ({ ...change, material: true })) }
    : entry);
  return { ...actual, LEGAL_INSTRUMENTS: instruments, legalChangeNotice: (accepted, entries = instruments) => actual.legalChangeNotice(accepted, entries) };
});

beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-test");
  harness.state.versions = { "terms-of-use": "0.0.0" };
  harness.state.calls = [];
  harness.state.failWrite = false;
  harness.state.holdRead = null;
  harness.state.backendUrl = "https://liveprojecttestref.supabase.co";
  localStorage.clear(); sessionStorage.clear();
  window.history.replaceState({}, "", "/m");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline test")));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("reads acceptance at sign-in, keeps a refused write visible, and dismisses only after confirmed storage and refresh", async () => {
  render(<App />);
  const prompt = await screen.findByRole("complementary", { name: "Terms acceptance" });
  expect(harness.state.calls.filter(({ name }) => name === "get_my_legal_acceptance_state")).toHaveLength(1);
  // A state, then both boxes: the terms and the age attestation it selects.
  fireEvent.change(within(prompt).getByRole("combobox"), { target: { value: "TX" } });
  for (const box of within(prompt).getAllByRole("checkbox")) fireEvent.click(box);
  harness.state.failWrite = true;
  fireEvent.click(within(prompt).getByRole("button", { name: "Accept and continue" }));
  expect(await within(prompt).findByRole("alert")).toHaveTextContent("nothing was stored");
  expect(prompt).toBeInTheDocument();
  harness.state.failWrite = false;
  fireEvent.click(within(prompt).getByRole("button", { name: "Accept and continue" }));
  await waitFor(() => expect(prompt).not.toBeInTheDocument());
  expect(harness.state.calls.filter(({ name }) => name === "record_legal_acceptance").map(({ args }) => args))
    .toEqual([
      { p_versions: currentLegalVersions(), p_residence_state: "TX", p_age_attested: true },
      { p_versions: currentLegalVersions(), p_residence_state: "TX", p_age_attested: true },
    ]);
  expect(harness.state.calls.filter(({ name }) => name === "get_my_legal_acceptance_state")).toHaveLength(2);
  await act(async () => harness.state.authChanged("TOKEN_REFRESHED", { ...harness.session }));
  expect(screen.queryByRole("complementary", { name: "Terms acceptance" })).not.toBeInTheDocument();
});

it("drops a late acceptance refresh once another account has signed in", async () => {
  render(<App />);
  const prompt = await screen.findByRole("complementary", { name: "Terms acceptance" });
  fireEvent.change(within(prompt).getByRole("combobox"), { target: { value: "TX" } });
  for (const box of within(prompt).getAllByRole("checkbox")) fireEvent.click(box);
  let release;
  harness.state.holdRead = new Promise((resolve) => { release = resolve; });
  fireEvent.click(within(prompt).getByRole("button", { name: "Accept and continue" }));
  await waitFor(() => expect(harness.state.calls.filter(({ name }) => name === "get_my_legal_acceptance_state")).toHaveLength(2));
  // Account A's refresh is still in flight when account B signs in on a fresh
  // session whose acceptance predates the material change.
  harness.state.holdRead = null;
  harness.state.versions = { "terms-of-use": "0.0.0" };
  const other = { user: { id: "member-2", email: "other@example.test" }, access_token: "fictional-other-token" };
  await act(async () => harness.state.authChanged("SIGNED_IN", other));
  await screen.findByRole("complementary", { name: "Terms acceptance" });
  await act(async () => { release(); });
  expect(screen.getByRole("complementary", { name: "Terms acceptance" })).toBeInTheDocument();
});

it("withholds every protected view while a material change is pending and renders the view after the acceptance is recorded", async () => {
  render(<App />);
  const prompt = await screen.findByRole("complementary", { name: "Terms acceptance" });
  const main = screen.getByRole("main");
  // The card is the only thing in the workspace column; no view, loading
  // state or error card sits beside it.
  expect(main.children).toHaveLength(1);
  expect(main.firstElementChild).toBe(prompt);
  expect(main.querySelector(".view-loading, .view-error")).toBeNull();
  fireEvent.change(within(prompt).getByRole("combobox"), { target: { value: "TX" } });
  for (const box of within(prompt).getAllByRole("checkbox")) fireEvent.click(box);
  fireEvent.click(within(prompt).getByRole("button", { name: "Accept and continue" }));
  await waitFor(() => expect(prompt).not.toBeInTheDocument());
  // After the acceptance the workspace renders its view again.
  await waitFor(() => expect(screen.getByRole("main").children.length).toBeGreaterThan(0));
});

it("withholds every view until the first acceptance read answers, not only after it reports a change", async () => {
  let release;
  harness.state.holdRead = new Promise((resolve) => { release = resolve; });
  render(<App />);
  await waitFor(() => expect(harness.state.calls.filter(({ name }) => name === "get_my_legal_acceptance_state")).toHaveLength(1));
  // The shell finishes loading its own data while the acceptance read is
  // still pending; the workspace must stay empty through that window.
  await waitFor(() => expect(document.querySelector(".view-loading")).toBeNull());
  expect(screen.getByRole("main").children).toHaveLength(0);
  await act(async () => { release(); });
  expect(await screen.findByRole("complementary", { name: "Terms acceptance" })).toBeInTheDocument();
});

it("keeps the profile dialog (Sign out) reachable from the card", async () => {
  render(<App />);
  const prompt = await screen.findByRole("complementary", { name: "Terms acceptance" });
  fireEvent.click(within(prompt).getByRole("button", { name: "Profile" }));
  expect(await screen.findByRole("button", { name: /Sign out/ })).toBeInTheDocument();
});

// BUG-UG-SAMPLE-ACCOUNTS-ASKED-TO-ACCEPT-TERMS-20261029: the SAMPLE
// project has no real users, so it never asks for terms.
it("never reads acceptance or shows the terms prompt when the main client connects to the SAMPLE project", async () => {
  harness.state.backendUrl = pinnedSampleSupabaseOrigin();
  render(<App />);
  // The member boot runs and the workspace renders a view, not the loading
  // screen, with no terms card in front of it.
  await waitFor(() => expect(harness.state.calls.some(({ name }) => name === "get_member_home_bootstrap")).toBe(true));
  await waitFor(() => {
    const main = screen.getByRole("main");
    expect(main.querySelector(".loading-screen, .view-loading")).toBeNull();
    expect(main.children.length).toBeGreaterThan(0);
  });
  expect(screen.queryByRole("complementary", { name: "Terms acceptance" })).not.toBeInTheDocument();
  expect(harness.state.calls.filter(({ name }) => name === "get_my_legal_acceptance_state" || name === "record_legal_acceptance")).toEqual([]);
});

it("still reads acceptance and asks when the main client connects to another project", async () => {
  render(<App />);
  expect(await screen.findByRole("complementary", { name: "Terms acceptance" })).toBeInTheDocument();
  expect(harness.state.calls.filter(({ name }) => name === "get_my_legal_acceptance_state")).toHaveLength(1);
});

// BUG-UG-TERMS-REACCEPTANCE-GATE-LOCKOUT-20261030 (finding 28, j/03):
// from 9:42 to 9:53 AM ET on October 30, 2026 Production served privacy 1.3.0
// while its database still refused it as "legal versions not current", and
// every try left the member locked out behind "nothing was stored".
it("lets the member in, with the real reason, while the database cannot record the versions this site shows", async () => {
  harness.state.failWrite = "pack";
  render(<App />);
  const prompt = await screen.findByRole("complementary", { name: "Terms acceptance" });
  fireEvent.change(within(prompt).getByRole("combobox"), { target: { value: "TX" } });
  for (const box of within(prompt).getAllByRole("checkbox")) fireEvent.click(box);
  fireEvent.click(within(prompt).getByRole("button", { name: "Accept and continue" }));
  expect(await within(prompt).findByRole("alert")).toHaveTextContent("still publishing these terms");
  expect(within(prompt).getByRole("alert")).not.toHaveTextContent("Check your connection");
  // The views open behind the card, which stays so the member can accept.
  await waitFor(() => expect(screen.getByRole("main").children.length).toBeGreaterThan(1));
  expect(screen.getByRole("main").firstElementChild).toBe(prompt);
  expect(harness.state.versions).toEqual({ "terms-of-use": "0.0.0" });
  // Once the database holds the same versions, the same card records them.
  harness.state.failWrite = false;
  fireEvent.click(within(prompt).getByRole("button", { name: "Accept and continue" }));
  await waitFor(() => expect(prompt).not.toBeInTheDocument());
  expect(harness.state.versions).toEqual(currentLegalVersions());
  expect(harness.state.calls.filter(({ name }) => name === "record_legal_acceptance")).toHaveLength(2);
});

it("releases only the account the database refused, through a token refresh but not an account switch", async () => {
  harness.state.failWrite = "pack";
  render(<App />);
  const prompt = await screen.findByRole("complementary", { name: "Terms acceptance" });
  fireEvent.change(within(prompt).getByRole("combobox"), { target: { value: "TX" } });
  for (const box of within(prompt).getAllByRole("checkbox")) fireEvent.click(box);
  fireEvent.click(within(prompt).getByRole("button", { name: "Accept and continue" }));
  await within(prompt).findByRole("alert");
  await waitFor(() => expect(screen.getByRole("main").children.length).toBeGreaterThan(1));
  await act(async () => harness.state.authChanged("TOKEN_REFRESHED", { ...harness.session, access_token: "fictional-refreshed-token" }));
  await waitFor(() => expect(harness.state.calls.filter(({ name }) => name === "get_my_legal_acceptance_state")).toHaveLength(2));
  expect(screen.getByRole("main").children.length).toBeGreaterThan(1);
  const other = { user: { id: "member-2", email: "other@example.test" }, access_token: "fictional-other-token" };
  await act(async () => harness.state.authChanged("SIGNED_IN", other));
  const next = await screen.findByRole("complementary", { name: "Terms acceptance" });
  await waitFor(() => expect(screen.getByRole("main").children).toHaveLength(1));
  expect(screen.getByRole("main").firstElementChild).toBe(next);
});

// Finding 28 (f/01, c/01): what the member entered must survive the session
// events a signed-in tab sees while the card is up.
it.each([
  ["TOKEN_REFRESHED", "fictional-refreshed-token"],
  ["SIGNED_IN", "fictional-test-token"],
])("keeps the state and both boxes through %s for the same account", async (event, token) => {
  render(<App />);
  const prompt = await screen.findByRole("complementary", { name: "Terms acceptance" });
  fireEvent.change(within(prompt).getByRole("combobox"), { target: { value: "TX" } });
  for (const box of within(prompt).getAllByRole("checkbox")) fireEvent.click(box);
  await act(async () => harness.state.authChanged(event, { ...harness.session, access_token: token }));
  const card = await screen.findByRole("complementary", { name: "Terms acceptance" });
  expect(within(card).getByRole("combobox")).toHaveValue("TX");
  for (const box of within(card).getAllByRole("checkbox")) expect(box).toBeChecked();
  fireEvent.click(within(card).getByRole("button", { name: "Accept and continue" }));
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "Terms acceptance" })).not.toBeInTheDocument());
  expect(harness.state.versions).toEqual(currentLegalVersions());
});
