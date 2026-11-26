import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { SubprocessorRegisterView } from "../src/views/SubprocessorRegisterView.jsx";
import { register, withoutReviewNote, appendProviderAmendment, appendProviderNotice, renderRegisterMarkdown } from "../src/lib/subprocessorRegister.js";
import { subprocessorsCatalogue } from "../src/lib/i18n/subprocessors.js";
import { hasRetiredProjectName } from "../scripts/lib/retired-project-names.mjs";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

const read = (file) => readFileSync(file, "utf8");
// The register's evidence also points at donor-repository records that are not
// part of Union Ground: operations evidence and specs under docs/, and the
// Cloudflare workers/ tree with its wrangler deploy configurations. Those
// pointers are listed, but only in-repo proof can be read here.
const EXCLUDED_EVIDENCE = /^(?:docs\/|workers\/|wrangler\.[^/]+\.jsonc$)/;
const evidenceHolds = ({ path, contains }) => {
  try {
    return read(path).includes(contains);
  } catch {
    return false;
  }
};

function resolveBaseRef(cwd, env) {
  // Full assurance fetches bare commits, so it has no origin/main ref and pins
  // the exact comparison base instead. Local runs and the manually dispatched
  // full checkouts still have the tracking branch. Neither may be guessed: a
  // base that resolves to nothing fails the guard instead of skipping it.
  // A checkout without origin/main can use its origin/HEAD tracking ref.
  if (env.ASSURANCE_BASE_REF) return env.ASSURANCE_BASE_REF;
  for (const [ref, name] of [["refs/remotes/origin/main", "origin/main"], ["refs/remotes/origin/HEAD", "origin/HEAD"]]) {
    try {
      const tracking = execFileSync("git", ["for-each-ref", "--format=%(objectname)", ref], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (tracking) return name;
    } catch {
      // Try the next tracking ref; none resolving fails the guard below.
    }
  }
  return null;
}

function readBaseRegister(cwd = process.cwd(), env = process.env) {
  const baseRef = resolveBaseRef(cwd, env);
  if (!baseRef) {
    throw new Error("Cannot verify subprocessor changes: set ASSURANCE_BASE_REF to the exact comparison base, or fetch origin/main, before running this suite");
  }
  try {
    // Compare against the fork point, not the base branch tip: a branch that
    // never touched the register must not fail because main changed it later.
    // A pin that is already an ancestor of HEAD resolves to itself.
    const forkPoint = execFileSync("git", ["merge-base", baseRef, "HEAD"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    // A fork point that predates the register (Union Ground's default
    // branch before the web sync) has nothing to retain: the change introduces
    // the register, and it must do so as a baseline (expectRetainedRegister).
    const tracked = execFileSync("git", ["ls-tree", "--name-only", forkPoint, "--", "src/data/subprocessors.json"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!tracked) return null;
    // The project was renamed to Union Ground; a base written under its former
    // name is compared with that name mapped, so the rename alone is not read
    // as a change to any retained provider or history row.
    return JSON.parse(execFileSync("git", ["show", `${forkPoint}:src/data/subprocessors.json`], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\b[a-z]{8} Ground\b/gi, (name) => hasRetiredProjectName(name) ? "Union Ground" : name));
  } catch (cause) {
    throw new Error(`Cannot verify subprocessor changes: fetch ${baseRef} and its src/data/subprocessors.json before running this suite`, { cause });
  }
}

function expectRetainedRegister(base, current) {
  if (base === null) {
    // Introduced by this change: exactly one baseline event naming every
    // listed provider, with no notice or amendment to replay yet.
    expect(current.history.map((entry) => entry.kind)).toEqual(["baseline"]);
    expect([...current.history[0].providers].sort()).toEqual(current.providers.map(({ id }) => id).sort());
    return;
  }
  expect(current.history.slice(0, base.history.length)).toEqual(base.history);
  // Replay every appended history row, in order, through the same strict
  // calendar-date, 15-day and chronology checks used to append a notice. Each
  // row may only announce providers that are new against the base, once each,
  // so a short notice naming a retained provider or a second notice for a new
  // provider cannot be published unchecked. An amendment row is replayed
  // through appendProviderAmendment: it names one retained provider, carries
  // that provider's prior row unchanged, and may only change scope text and
  // evidence, never identity, location, sources or start date.
  let replayed = base;
  const noticed = new Map();
  const amended = new Set();
  for (const entry of current.history.slice(base.history.length)) {
    expect(["notice", "amendment"], "appended history kind").toContain(entry.kind);
    expect(entry.providers.length, "history providers").toBeGreaterThan(0);
    if (entry.kind === "amendment") {
      expect(entry.providers, "amendment providers").toHaveLength(1);
      const [id] = entry.providers;
      expect(base.providers.some((provider) => provider.id === id), `${id} amendment of a retained provider`).toBe(true);
      expect(amended.has(id), `${id} amended once per change`).toBe(false);
      const provider = current.providers.find((candidate) => candidate.id === id);
      expect(provider, `${id} amended provider row`).toBeDefined();
      const before = replayed.providers.find((candidate) => candidate.id === id);
      replayed = appendProviderAmendment(replayed, provider, entry.announced, entry.summary);
      expect(current.providers.filter((candidate) => candidate.id === id), `${id} single validated amendment`)
        .toEqual([replayed.providers.find((candidate) => candidate.id === id)]);
      expect(entry, `${id} amendment row`).toEqual(replayed.history.at(-1));
      expect(entry.previous, `${id} prior row retained`).toEqual(before);
      amended.add(id);
      continue;
    }
    for (const id of entry.providers) {
      const provider = current.providers.find((candidate) => candidate.id === id);
      expect(provider, `${id} noticed provider row`).toBeDefined();
      replayed = appendProviderNotice(replayed, provider, entry.announced, entry.starts);
      noticed.set(id, entry.starts);
    }
  }
  for (const provider of current.providers) {
    const previous = base.providers.find(({ id }) => id === provider.id);
    if (previous && amended.has(provider.id)) {
      // An amendment may only drop proof that no longer holds; proof that
      // still holds stays listed byte-identical.
      for (const entry of previous.evidence || []) {
        if (evidenceHolds(entry)) expect(provider.evidence, `${provider.id} live evidence kept`).toContainEqual(entry);
      }
    } else if (previous) {
      // Provider retirement leaves history intact. Retained providers cannot
      // silently change their identity, locations, scope or processing date.
      // Additional proof is allowed, but existing proof stays byte-identical.
      const { evidence = [], sources = [], ...fields } = provider;
      const { evidence: oldEvidence = [], sources: oldSources = [], ...oldFields } = previous;
      expect(fields, provider.id).toEqual(oldFields);
      expect(evidence.slice(0, oldEvidence.length), `${provider.id} evidence`).toEqual(oldEvidence);
      expect(sources.slice(0, oldSources.length), `${provider.id} sources`).toEqual(oldSources);
    } else {
      // The replay above already applied the strict UTC calendar-date checks;
      // Date.parse alone accepts rolled-over dates such as February 30.
      expect(noticed.has(provider.id), `${provider.id} advance notice`).toBe(true);
      expect(provider.starts, `${provider.id} starts`).toBe(noticed.get(provider.id));
    }
  }
}

describe("public subprocessor register", () => {
  it("falls back to the English catalogue for an unsupported locale", () => {
    const html = renderToStaticMarkup(<LanguageProvider lang="fr"><SubprocessorRegisterView /></LanguageProvider>);
    const text = new DOMParser().parseFromString(html, "text/html").body.textContent;
    expect(text).toContain(register.copy.en.title);
    for (const provider of register.providers) {
      expect(text).toContain(withoutReviewNote(provider.en.country));
      expect(text).toContain(provider.en.scope);
      for (const source of provider.sources || []) expect(text).toContain(source.en);
    }
    for (const event of register.history.filter(({ kind }) => kind === "amendment")) expect(text).toContain(event.summary.en);
    expect(text).not.toContain("subprocessors.");
  });
  it.each(["en", "es"])("publishes capability data with no internal review notes in %s", (lang) => {
    const html = renderToStaticMarkup(<LanguageProvider lang={lang}><SubprocessorRegisterView /></LanguageProvider>);
    expect(JSON.stringify(register)).not.toMatch(/\[B-\d/);
    expect(html).not.toMatch(/\[B-\d/);
    expect(renderRegisterMarkdown(lang)).not.toMatch(/\[B-\d/);
  });
  it.each(["en", "es"])("renders the shared providers, scopes and notice policy in %s", (lang) => {
    const html = renderToStaticMarkup(<LanguageProvider lang={lang}><SubprocessorRegisterView /></LanguageProvider>);
    const text = new DOMParser().parseFromString(html, "text/html").body.textContent;
    expect(html).toContain(register.reviewed);
    for (const provider of register.providers) {
      expect(html).toContain(provider.name);
      expect(text).toContain(withoutReviewNote(provider[lang].country));
      expect(text).toContain(provider[lang].scope);
      expect(register.history.some((entry) => entry.providers.includes(provider.id))).toBe(true);
    }
    for (const event of register.history.filter(({ kind }) => kind === "amendment")) {
      expect(text).toContain(event.summary[lang]);
      expect(text).toContain(`${register.copy[lang].previousScope}: ${event.previous[lang].scope}`);
    }
    // Read the decoded text: React escapes the apostrophe in Union Ground's copy.
    expect(text).toContain(register.copy[lang].notice);
    expect(register.copy[lang].notice).toMatch(lang === "es" ? /al menos 15 días de antelación/ : /at least 15 days’ notice/);
    expect(text).toContain(register.copy[lang].remedy);
    expect(text).toContain(register.copy[lang].notOperative);
  });
  it("publishes a routable static document and a privacy link", () => {
    expect(read("src/AppRouter.jsx")).toContain('"/subprocessors": SubprocessorRegisterView');
    expect(read("scripts/public-route-metadata.mjs")).toContain('"/subprocessors"');
    expect(read("src/lib/publicPageMetadata.js")).toContain('"/subprocessors"');
    expect(read("src/views/LegalView.jsx")).toContain('href="/subprocessors"');
  });
  it.each(["en", "es"])("shows operator-dependent processing for each supported provider in %s", (lang) => {
    const location = lang === "en"
      ? "Depends on the operator’s configuration."
      : "Depende de la configuración del operador.";
    expect(register.providers.map(({ id }) => id).sort())
      .toEqual(["cloudflare", "fireworks", "posthog", "resend", "sentry", "supabase", "vercel"]);
    for (const provider of register.providers) {
      expect(provider[lang].country, provider.id).toBe(location);
      expect(provider[lang].scope, provider.id).toMatch(lang === "en" ? /when the operator/ : /cuando el operador/);
      expect(JSON.stringify(provider), provider.id).not.toMatch(/unionground\.net|us-east-1|us\.i\.posthog\.com|B-\d|supabase\.co/i);
      expect(siblingIdentityIn(JSON.stringify(provider)), provider.id).toEqual([]);
      // Proof is in-repo code, never a sibling product's operations record.
      for (const entry of provider.evidence) expect(entry.path, provider.id).not.toMatch(EXCLUDED_EVIDENCE);
    }
    const html = renderToStaticMarkup(<LanguageProvider lang={lang}><SubprocessorRegisterView /></LanguageProvider>);
    // Provider statements stay labelled as such, dated, and linked.
    for (const id of ["resend", "fireworks", "cloudflare"]) {
      const provider = register.providers.find((entry) => entry.id === id);
      expect(provider.sources.length).toBeGreaterThan(0);
      for (const source of provider.sources) {
        expect(source.read).toBe("2026-10-10");
        expect(html).toContain(`href="${source.url}"`);
        expect(renderRegisterMarkdown(lang)).toContain(source.url);
        expect(renderRegisterMarkdown(lang)).toContain(source.read);
      }
    }
  });
  it("appends an immutable dated notice and refuses less than 15 days", () => {
    const provider = { ...register.providers[0], id: "fixture", name: "Fixture provider" };
    const before = structuredClone(register);
    expect(() => appendProviderNotice(before, provider, "2026-11-06", "2026-11-20")).toThrow(/15/);
    const next = appendProviderNotice(before, provider, "2026-11-06", "2026-11-21");
    expect(before).toEqual(register);
    expect(next.history.slice(0, -1)).toEqual(register.history);
    expect(next.history.at(-1)).toMatchObject({ announced: "2026-11-06", starts: "2026-11-21", providers: ["fixture"] });
    expect(() => appendProviderNotice(next, provider, "2026-11-07", "2026-11-22")).toThrow(/duplicate/);
  });
  it("keeps every retained change byte-identical", () => {
    expectRetainedRegister(readBaseRegister(), register);
  });
  it("fails with a fetch instruction when origin/main is unavailable", () => {
    const emptyRepo = mkdtempSync(join(tmpdir(), "subprocessor-base-"));
    try {
      execFileSync("git", ["init", "--quiet", emptyRepo]);
      expect(() => readBaseRegister(emptyRepo, {})).toThrow(/fetch origin\/main/);
    } finally {
      rmSync(emptyRepo, { recursive: true, force: true });
    }
  });
  it("prefers the pinned comparison base over a tracking branch and refuses an unresolvable base", () => {
    const repo = mkdtempSync(join(tmpdir(), "subprocessor-ci-base-"));
    const git = (...args) => execFileSync("git", args, {
      cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    try {
      git("init", "--quiet");
      mkdirSync(join(repo, "src/data"), { recursive: true });
      writeFileSync(join(repo, "src/data/subprocessors.json"), JSON.stringify(register));
      git("add", "src/data/subprocessors.json");
      git("-c", "user.name=Register fixture", "-c", "user.email=fixture@example.test",
        "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", "Pinned base");
      const baseRef = git("rev-parse", "HEAD");
      expect(git("for-each-ref", "refs/remotes/origin/main")).toBe("");
      expect(readBaseRegister(repo, { ASSURANCE_BASE_REF: baseRef })).toEqual(register);
      expect(() => readBaseRegister(repo, {})).toThrow(/fetch origin\/main/);

      // Give the tracking branch different bytes so fallback cannot mask
      // a missing pin or a pinned read that silently chose the local branch.
      const trackingRegister = { ...register, reviewed: "2000-01-01" };
      writeFileSync(join(repo, "src/data/subprocessors.json"), JSON.stringify(trackingRegister));
      git("add", "src/data/subprocessors.json");
      git("-c", "user.name=Register fixture", "-c", "user.email=fixture@example.test",
        "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", "Local branch");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      expect(readBaseRegister(repo, {})).toEqual(trackingRegister);
      expect(readBaseRegister(repo, { ASSURANCE_BASE_REF: baseRef })).toEqual(register);
      expect(() => readBaseRegister(repo, { ASSURANCE_BASE_REF: "missing-base" }))
        .toThrow(/fetch missing-base/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it("compares a branch that never touched the register against its fork point, not a later main", () => {
    const repo = mkdtempSync(join(tmpdir(), "subprocessor-fork-point-"));
    const git = (...args) => execFileSync("git", args, {
      cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const commit = (message) => git("-c", "user.name=Register fixture", "-c", "user.email=fixture@example.test",
      "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", message);
    try {
      git("init", "--quiet");
      mkdirSync(join(repo, "src/data"), { recursive: true });
      writeFileSync(join(repo, "src/data/subprocessors.json"), JSON.stringify(register));
      git("add", "src/data/subprocessors.json");
      commit("Fork point");
      const forkPoint = git("rev-parse", "HEAD");
      // main later appends Resend evidence; the feature branch edits another file.
      const later = structuredClone(register);
      later.providers.find(({ id }) => id === "resend").evidence.push({ path: "later-proof.md", contains: "later" });
      writeFileSync(join(repo, "src/data/subprocessors.json"), JSON.stringify(later));
      git("add", "src/data/subprocessors.json");
      commit("Later main");
      const laterMain = git("rev-parse", "HEAD");
      git("checkout", "--quiet", "-b", "feature", forkPoint);
      writeFileSync(join(repo, "unrelated.txt"), "feature change\n");
      git("add", "unrelated.txt");
      commit("Feature");
      git("update-ref", "refs/remotes/origin/main", laterMain);
      for (const env of [{}, { ASSURANCE_BASE_REF: laterMain }]) {
        const base = readBaseRegister(repo, env);
        expect(base).toEqual(register);
        expectRetainedRegister(base, register);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it.each([
    ["name", "Replacement service"],
    ["en.country", "Different processing location"],
    ["en.scope", "Different data scope"],
    ["es.country", "Otro lugar de tratamiento"],
    ["es.scope", "Otros datos tratados"],
    ["starts", "2026-11-07"],
    ["evidence.0.contains", "changed evidence"],
    ["sources.0.url", "https://example.com/changed-source"],
  ])("rejects a silent change to an existing provider's %s", (path, value) => {
    const changed = structuredClone(register);
    const keys = path.split(".");
    const provider = changed.providers.find(({ id }) => id === "resend");
    const target = keys.slice(0, -1).reduce((object, key) => object[key], provider);
    target[keys.at(-1)] = value;
    expect(() => expectRetainedRegister(register, changed)).toThrow();
  });
  it("allows appended evidence and a retirement while preserving prior notices", () => {
    const changed = structuredClone(register);
    changed.providers[0].evidence.push({ path: "new-proof.md", contains: "observation" });
    changed.providers[0].sources = [{ url: "https://example.com/source" }];
    changed.providers.pop();
    expectRetainedRegister(register, changed);
  });
  it("accepts exactly 15 calendar days across the daylight-saving transition", () => {
    const provider = { ...register.providers[0], id: "fixture", name: "Fixture provider" };
    // US daylight saving time begins March 14, 2027, after the newest notice.
    const changed = appendProviderNotice(register, provider, "2027-03-08", "2027-03-23");
    expectRetainedRegister(register, changed);
  });
  it.each([
    ["2026-11-07", "2026-11-21"],
    ["2026-11-31", "2026-12-16"],
    ["2027-02-14", "2027-02-30"],
    ["2026-11-07T00:00:00Z", "2026-11-22"],
    ["2026-11-07", "2026-11-22T00:00:00Z"],
  ])("rejects an invalid or short notice from %s to %s", (announced, starts) => {
    const changed = structuredClone(register);
    changed.providers.push({ ...register.providers[0], id: "fixture", name: "Fixture provider", starts });
    changed.history.push({ kind: "notice", announced, starts, providers: ["fixture"] });
    expect(() => expectRetainedRegister(register, changed)).toThrow();
  });
  it("rejects a provider whose processing date differs from its advance notice", () => {
    const provider = { ...register.providers[0], id: "fixture", name: "Fixture provider" };
    const changed = appendProviderNotice(register, provider, "2026-11-06", "2026-11-21");
    changed.providers.at(-1).starts = "2026-11-15";
    expect(() => expectRetainedRegister(register, changed)).toThrow();
  });
  it("rejects a rewritten or removed history entry", () => {
    const rewritten = structuredClone(register);
    rewritten.history[0].announced = "2020-01-01";
    expect(() => expectRetainedRegister(register, rewritten)).toThrow();
    const removed = structuredClone(register);
    removed.history.shift();
    expect(() => expectRetainedRegister(register, removed)).toThrow();
  });
  it.each([
    ["a short notice naming a retained provider", (changed) => {
      changed.history.push({ kind: "notice", announced: "2026-10-11", starts: "2026-10-12", providers: ["resend"] });
    }],
    ["a valid-length notice naming a retained provider", (changed) => {
      changed.history.push({ kind: "notice", announced: "2026-10-11", starts: "2026-10-26", providers: ["resend"] });
    }],
    ["a later invalid notice for a new provider", (changed) => {
      changed.history.push({ kind: "notice", announced: "2027-02-14", starts: "2027-02-30", providers: ["fixture"] });
    }],
    ["a second new provider announced out of order", (changed) => {
      changed.providers.push({ ...register.providers[0], id: "second", name: "Second provider", starts: "2026-10-25" });
      changed.history.push({ kind: "notice", announced: "2026-10-10", starts: "2026-10-25", providers: ["second"] });
    }],
    ["a notice for a provider with no row", (changed) => {
      changed.history.push({ kind: "notice", announced: "2026-11-10", starts: "2026-11-25", providers: ["absent"] });
    }],
    ["a non-notice row", (changed) => {
      changed.history.push({ kind: "baseline", announced: "2026-11-10", providers: ["fixture"] });
    }],
  ])("rejects an appended history row that is %s", (_label, mutate) => {
    const provider = { ...register.providers[0], id: "fixture", name: "Fixture provider" };
    const changed = appendProviderNotice(register, provider, "2026-11-07", "2026-11-22");
    expectRetainedRegister(register, changed);
    mutate(changed);
    expect(() => expectRetainedRegister(register, changed)).toThrow();
  });
  // An amendment fixture: Resend's base row carries one proof that no longer
  // holds, and the amendment narrows its scope in both languages and drops
  // only that dead proof.
  const deadProof = { path: "src/lib/subprocessorRegister.js", contains: "this sentence is not in the file" };
  // Resend's own first proof is a donor operations record that Union Ground
  // does not carry, so the fixture adds one in-repo proof that still holds.
  const liveProof = { path: "src/lib/subprocessorRegister.js", contains: "export function appendProviderAmendment" };
  const amendmentSummary = { en: "Narrowed for the fixture.", es: "Reducido para la prueba." };
  const amendmentBase = () => {
    const base = structuredClone(register);
    base.providers.find(({ id }) => id === "resend").evidence.push(liveProof, deadProof);
    return base;
  };
  const narrowedResend = (base) => {
    const provider = structuredClone(base.providers.find(({ id }) => id === "resend"));
    provider.en.scope = "Email delivery: recipient address and message content for invitations only.";
    provider.es.scope = "Entrega de correo: dirección del destinatario y contenido de las invitaciones únicamente.";
    provider.evidence = provider.evidence.filter((entry) => entry !== deadProof && entry.contains !== deadProof.contains);
    return provider;
  };
  const amendedRegister = () => {
    const base = amendmentBase();
    return { base, changed: appendProviderAmendment(base, narrowedResend(base), "2026-11-07", amendmentSummary) };
  };

  it("accepts a dated amendment that narrows a retained provider's scope and drops only dead proof", () => {
    expect(evidenceHolds(deadProof)).toBe(false);
    const { base, changed } = amendedRegister();
    expect(changed.history.slice(0, -1)).toEqual(base.history);
    expect(changed.history.at(-1)).toEqual({
      kind: "amendment", announced: "2026-11-07", providers: ["resend"], summary: amendmentSummary,
      previous: base.providers.find(({ id }) => id === "resend"),
    });
    expectRetainedRegister(base, changed);
    // A later notice still replays after the amendment.
    const provider = { ...register.providers[0], id: "fixture", name: "Fixture provider" };
    expectRetainedRegister(base, appendProviderNotice(changed, provider, "2026-11-07", "2026-11-22"));
  });
  it.each([
    ["a location change", (provider) => { provider.en.country = "Ireland"; }],
    ["a Spanish location change", (provider) => { provider.es.country = "Irlanda"; }],
    ["a renamed provider", (provider) => { provider.name = "Replacement service"; }],
    ["a new start date", (provider) => { provider.starts = "2026-11-22"; }],
    ["a changed source", (provider) => { provider.sources[0].url = "https://example.com/changed-source"; }],
    ["an added field", (provider) => { provider.region = "eu"; }],
    ["an added language field", (provider) => { provider.en.retention = "forever"; }],
    ["a scope changed in only one language", (provider, base) => { provider.es.scope = base.providers.find(({ id }) => id === "resend").es.scope; }],
    ["no remaining evidence", (provider) => { provider.evidence = []; }],
    ["an unknown provider", (provider) => { provider.id = "absent"; }],
  ])("refuses an amendment carrying %s", (_label, mutate) => {
    const base = amendmentBase();
    const provider = narrowedResend(base);
    mutate(provider, base);
    expect(() => appendProviderAmendment(base, provider, "2026-11-07", amendmentSummary)).toThrow();
  });
  it.each([
    ["has an invalid date", ["2026-02-30", amendmentSummary]],
    ["predates the last history row", ["2026-10-09", amendmentSummary]],
    ["lacks a Spanish summary", ["2026-11-07", { en: "Narrowed." }]],
  ])("refuses an amendment that %s", (_label, [announced, summary]) => {
    const base = amendmentBase();
    expect(() => appendProviderAmendment(base, narrowedResend(base), announced, summary)).toThrow();
  });
  it.each([
    ["an amendment with a second renamed row for the same provider", ({ changed }) => {
      const duplicate = structuredClone(changed.providers.find(({ id }) => id === "resend"));
      duplicate.name = "Different provider using the retained ID";
      changed.providers.push(duplicate);
      return changed;
    }],
    ["an amendment with an identical duplicate provider row", ({ changed }) => {
      changed.providers.push(structuredClone(changed.providers.find(({ id }) => id === "resend")));
      return changed;
    }],
    ["a widened scope with no amendment or notice", ({ base }) => {
      const changed = structuredClone(base);
      changed.providers.find(({ id }) => id === "resend").en.scope += " Also marketing lists and contact uploads.";
      return changed;
    }],
    ["an amendment that drops proof that still holds", ({ base, changed }) => {
      const resend = changed.providers.find(({ id }) => id === "resend");
      expect(evidenceHolds(liveProof)).toBe(true);
      resend.evidence = resend.evidence.filter((entry) => entry.contains !== liveProof.contains);
      changed.history.at(-1).previous = base.providers.find(({ id }) => id === "resend");
      return changed;
    }],
    ["an amendment whose prior row was rewritten", ({ changed }) => {
      changed.history.at(-1).previous.en.scope = "Something softer than what was published.";
      return changed;
    }],
    ["an amendment that adds a provider", ({ changed }) => {
      changed.providers.push({ ...register.providers[0], id: "fixture", name: "Fixture provider" });
      changed.history.push({ ...changed.history.at(-1), providers: ["fixture"], previous: changed.providers.at(-1) });
      return changed;
    }],
    ["an amendment naming two providers", ({ changed }) => {
      changed.history.at(-1).providers.push("vercel");
      return changed;
    }],
    ["a second amendment of the same provider", ({ changed }) => {
      const resend = structuredClone(changed.providers.find(({ id }) => id === "resend"));
      resend.en.scope = "Email delivery: invitations only, without message content.";
      resend.es.scope = "Entrega de correo: solo invitaciones, sin contenido.";
      return appendProviderAmendment(changed, resend, "2026-11-08", amendmentSummary);
    }],
    ["a later edit to the amended row", ({ changed }) => {
      changed.providers.find(({ id }) => id === "resend").en.country = "Ireland";
      return changed;
    }],
    ["an amendment row with no summary", ({ changed }) => {
      delete changed.history.at(-1).summary;
      return changed;
    }],
  ])("rejects %s", (_label, build) => {
    const changed = build(amendedRegister());
    expect(() => expectRetainedRegister(amendmentBase(), changed)).toThrow();
  });
  // The view's three conditional shapes only exist once a provider is under
  // advance notice, and the reviewed register is still all baseline: no entry
  // carries a start date, every history event is the baseline one, and every
  // id it names is still in the live table. Build that announced state from
  // the reviewed register and render the real view against it, so the start
  // date, the dated-notice sentence and the retired-id fallback are proven on
  // the page rather than assumed.
  const announcedRegister = () => {
    const next = structuredClone(register);
    const announced = next.providers.at(-1);
    announced.starts = "2026-11-02";
    next.history = [
      ...next.history,
      { kind: "notice", announced: "2026-10-18", starts: announced.starts, providers: [announced.id] },
      // A provider that stopped being a subprocessor leaves the live table but
      // never leaves the history, so the list has to name the bare id.
      { kind: "notice", announced: "2026-10-19", starts: "2026-11-03", providers: ["retired-mailer"] },
    ];
    return next;
  };

  const renderAnnounced = async (lang, fixture) => {
    vi.resetModules();
    vi.doMock("../src/lib/subprocessorRegister.js", () => ({ register: fixture, withoutReviewNote }));
    // Both modules come from the reset registry: a statically imported
    // LanguageProvider would hand the freshly imported view a different
    // context object and every t() call would fall back to the default.
    // The reset registry also drops the Spanish table tests/setup.js
    // registered, so register it again on the fresh catalogue first.
    await import("../src/lib/i18n/allLanguages.js");
    const { SubprocessorRegisterView: View } = await import("../src/views/SubprocessorRegisterView.jsx");
    const { LanguageProvider: Provider } = await import("../src/lib/LanguageContext.jsx");
    return renderToStaticMarkup(<Provider lang={lang}><View /></Provider>);
  };

  const restoreRegister = () => {
    vi.doUnmock("../src/lib/subprocessorRegister.js");
    vi.resetModules();
  };

  it.each(["en", "es"])("dates an announced provider and its notice, and keeps a retired id, in %s", async (lang) => {
    const fixture = announcedRegister();
    const announced = fixture.providers.at(-1);
    let html;
    try {
      html = await renderAnnounced(lang, fixture);
    } finally {
      restoreRegister();
    }
    const text = new DOMParser().parseFromString(html, "text/html").body.textContent;
    const copy = register.copy[lang];
    // The provider entry carries the start date, and so does its history line.
    expect(text).toContain(`${copy.starts}: ${announced.starts}`);
    expect(text).toContain(`${copy.starts}: 2026-11-03.`);
    expect(text).toContain("retired-mailer");
    // The baseline event keeps its own sentence, not a start date.
    expect(text).toContain(copy.baseline);
    expect(html).toContain('dateTime="2026-10-19"');
    expect(text).not.toContain("subprocessors.");
  });

  it.each(["en", "es"])("retains advance-notice start dates in the generated %s legal document", async (lang) => {
    const fixture = announcedRegister();
    const provider = fixture.providers.at(-1);
    vi.resetModules();
    vi.doMock("../src/data/subprocessors.json", () => ({ default: fixture }));
    try {
      const { renderRegisterMarkdown: render } = await import("../src/lib/subprocessorRegister.js");
      const markdown = render(lang);
      const starts = lang === "en" ? "Earliest processing date" : "Primera fecha posible de tratamiento";
      expect(markdown).toContain(`- 2026-10-18: ${provider.id}. ${starts}: 2026-11-02.`);
      expect(markdown).toContain(`- 2026-10-19: retired-mailer. ${starts}: 2026-11-03.`);
      expect(markdown).toContain(register.copy[lang].baseline);
    } finally {
      vi.doUnmock("../src/data/subprocessors.json");
      vi.resetModules();
    }
  });

  it("ships a capability baseline without another deployment’s notices", () => {
    expectRetainedRegister(null, register);
    for (const provider of register.providers) expect(provider.starts).toBeUndefined();
  });

  it("has the same field structure and evidence in both languages", () => {
    expect(Object.keys(register.copy.en).sort()).toEqual(Object.keys(register.copy.es).sort());
    for (const provider of register.providers) {
      expect(Object.keys(provider.en).sort()).toEqual(Object.keys(provider.es).sort());
      expect(provider.evidence.length).toBeGreaterThan(0);
      for (const source of provider.evidence.filter(({ path }) => !EXCLUDED_EVIDENCE.test(path))) {
        expect(read(source.path), source.path).toContain(source.contains);
      }
    }
  });

  // The view reads each provider through explicit catalogue keys, and a
  // missing key renders verbatim, so an appended notice must add its keys too.
  it("has catalogue keys for every provider and source in both languages", () => {
    for (const lang of ["en", "es"]) {
      for (const provider of register.providers) {
        const keys = ["country", "scope", ...(provider.sources || []).map((_, index) => `source.${index}`)];
        for (const key of keys) {
          const value = subprocessorsCatalogue[lang][`subprocessors.provider.${provider.id}.${key}`];
          const expected = key.startsWith("source.") ? provider.sources[Number(key.slice(7))][lang] : provider[lang][key];
          expect(value, `${lang} ${provider.id} ${key}`).toBe(expected);
        }
      }
    }
  });
});
