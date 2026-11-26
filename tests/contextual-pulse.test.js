// @vitest-environment node
// REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001 (CR-014): the shared
// client rules for reading-screen quick checks, and the migration that
// enforces them on the server.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_PULSE_CONTEXTS,
  DEFAULT_PULSE_CONTEXT,
  PULSE_CONTEXTS,
  PULSE_DEFAULTS,
  PULSE_HUB_THREAD_KINDS,
  PULSE_SESSION_STORAGE_KEY,
  isBlockedPulseContext,
  isProductPulseContext,
  markPulseSessionUsed,
  normalizePulseDecision,
  pulseContextLabelKey,
  pulseDecisionEndsSession,
  pulseSessionKey,
  pulseSessionUsed,
  pulseSettings,
  pulseThresholdMet,
  scrollPercentOf,
} from "../src/features/engagement/contextualPulse.js";
import { catalogue } from "../src/lib/i18n.js";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";

const migration = readFileSync(
  "supabase/migrations/20261002136000_contextual_pulse_triggers_and_engagement_producers.sql",
  "utf8",
);

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

describe("reading-screen quick check rules", () => {
  it("restores the old reading screens and keeps the Voice page prompt that works today", () => {
    expect(PULSE_CONTEXTS.map((context) => context.key)).toEqual([
      "voice.open", "contract.page", "rights.page", "qa.detail", "issue-thread.detail",
    ]);
    expect(DEFAULT_PULSE_CONTEXT).toBe("voice.open");
    expect(isProductPulseContext("contract.page")).toBe(true);
    expect(isProductPulseContext("voice.open")).toBe(false);
    expect(isProductPulseContext("case.updated")).toBe(false);
  });

  it("never asks on report, retaliation, grievance, recovery, case or step-up screens", () => {
    for (const key of ["report-issue.form", "retaliation.report", "grievance.filing", "account.recovery", "case.detail", "case.updated", "mfa.challenge"]) {
      expect(isBlockedPulseContext(key)).toBe(true);
      expect(isProductPulseContext(key)).toBe(false);
    }
    expect(PULSE_HUB_THREAD_KINDS).toEqual(["topic", "issue", "decision"]);
  });

  it("matches the server registry exactly", () => {
    const registry = migration.slice(
      migration.indexOf("create function private.contextual_pulse_context_class"),
      migration.indexOf("revoke all on function private.contextual_pulse_context_class"),
    );
    for (const context of PULSE_CONTEXTS) expect(registry).toContain(`when '${context.key}' then '${context.kind}'`);
    for (const key of BLOCKED_PULSE_CONTEXTS) expect(registry).toContain(`when '${key}' then 'blocked'`);
    expect(registry.match(/ then '(voice|product|blocked)'/g)).toHaveLength(PULSE_CONTEXTS.length + BLOCKED_PULSE_CONTEXTS.length);
  });

  it("reads the organization's member-visible switch and limits with the old defaults as fallback", () => {
    expect(PULSE_DEFAULTS).toEqual({ enabled: false, dwellSeconds: 20, scrollPercent: 50 });
    expect(pulseSettings(null)).toEqual(PULSE_DEFAULTS);
    expect(pulseSettings({ switches: {
      "features.engagement_voice.contextual_pulses": true,
      "limits.engagement_voice.pulse_dwell_seconds": 45,
      "limits.engagement_voice.pulse_scroll_percent": 70,
    } })).toEqual({ enabled: true, dwellSeconds: 45, scrollPercent: 70 });
  });

  it("asks once the dwell OR the scroll threshold is met, as the old slot did", () => {
    expect(pulseThresholdMet({ dwellSeconds: 19, scrollPercent: 49 })).toBe(false);
    expect(pulseThresholdMet({ dwellSeconds: 20, scrollPercent: 0 })).toBe(true);
    expect(pulseThresholdMet({ dwellSeconds: 0, scrollPercent: 50 })).toBe(true);
    expect(pulseThresholdMet({ dwellSeconds: 30, scrollPercent: 0 }, { dwellSeconds: 45, scrollPercent: 70 })).toBe(false);
  });

  it("measures scroll depth and treats an unscrollable page as zero", () => {
    expect(scrollPercentOf({ scrollTop: 0, scrollHeight: 800, clientHeight: 800 })).toBe(0);
    expect(scrollPercentOf({ scrollTop: 300, scrollHeight: 1400, clientHeight: 800 })).toBe(50);
    expect(scrollPercentOf({ scrollTop: 900, scrollHeight: 1400, clientHeight: 800 })).toBe(100);
    expect(scrollPercentOf({ scrollTop: -20, scrollHeight: 1400, clientHeight: 800 })).toBe(0);
  });

  it("keeps one session key per tab session and remembers when the session is spent", () => {
    const storage = memoryStorage();
    const first = pulseSessionKey(storage, () => "4d0b0d9a-1c3a-4c8e-9a51-6c3c1f0f6b11");
    expect(first).toBe("4d0b0d9a-1c3a-4c8e-9a51-6c3c1f0f6b11");
    expect(pulseSessionKey(storage, () => "00000000-0000-4000-8000-000000000000")).toBe(first);
    expect(pulseSessionKey(memoryStorage({ [PULSE_SESSION_STORAGE_KEY]: "not-a-uuid" }), () => "4d0b0d9a-1c3a-4c8e-9a51-6c3c1f0f6b12"))
      .toBe("4d0b0d9a-1c3a-4c8e-9a51-6c3c1f0f6b12");
    expect(pulseSessionKey({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } }, () => "4d0b0d9a-1c3a-4c8e-9a51-6c3c1f0f6b13"))
      .toBe("4d0b0d9a-1c3a-4c8e-9a51-6c3c1f0f6b13");
    expect(pulseSessionUsed(storage)).toBe(false);
    markPulseSessionUsed(storage);
    expect(pulseSessionUsed(storage)).toBe(true);
  });

  it("renders only a well-formed eligible answer and ends the session on a shown or spent session", () => {
    expect(normalizePulseDecision(null)).toEqual({ eligible: false, reason: null, prompt: null });
    expect(normalizePulseDecision({ eligible: false, reason: "sampled_out" }).reason).toBe("sampled_out");
    expect(normalizePulseDecision({ eligible: true, eventId: "e", question: "Clear?", options: ["Yes"] }).eligible).toBe(false);
    const shown = normalizePulseDecision({ eligible: true, eventId: "e", promptId: "p", question: "Clear?", options: ["Yes", "No"], contextKey: "contract.page" });
    expect(shown.prompt).toEqual({ eventId: "e", promptId: "p", question: "Clear?", options: ["Yes", "No"], contextKey: "contract.page" });
    expect(pulseDecisionEndsSession(shown)).toBe(true);
    expect(pulseDecisionEndsSession({ eligible: false, reason: "session_already_used" })).toBe(true);
    expect(pulseDecisionEndsSession({ eligible: false, reason: "engagement_not_met" })).toBe(false);
  });

  it("names every screen in English and Spanish", () => {
    for (const context of PULSE_CONTEXTS) {
      const key = pulseContextLabelKey(context.key);
      expect(catalogue.en[key]).toBeTruthy();
      expect(catalogue.es[key]).toBeTruthy();
    }
    expect(pulseContextLabelKey("case.updated")).toBeNull();
    for (const key of ["engagement.pulseContextUnknown", "engagement.pulseContextHintVoice", "engagement.pulseContextHintProduct", "engagement.pulseContextHintUnknown"]) {
      expect(catalogue.en[key]).toBeTruthy();
      expect(catalogue.es[key]).toBeTruthy();
    }
  });
});

describe("the CR-014 and CR-039/040 migration", () => {
  const keys = [
    ["features.engagement_voice.contextual_pulses", "'true'", "true"],
    ["limits.engagement_voice.pulse_dwell_seconds", "'20'", "true"],
    ["limits.engagement_voice.pulse_scroll_percent", "'50'", "true"],
    ["limits.engagement_voice.pulse_weekly_target", "'40'", "false"],
    ["limits.engagement_voice.pulse_sampling_percent", "'35'", "false"],
    ["features.analytics.engagement_event_producers", "'true'", "false"],
  ];

  it("registers every switch and limit with its default (old, or D6 for quick checks), category and visibility, EN and ES", () => {
    for (const [key, defaultValue, memberVisible] of keys) {
      const definition = migration.match(new RegExp(`\\('${key.replaceAll(".", "\\.")}', '(boolean|integer)',[\\s\\S]*?'(engagement_voice|analytics)', (true|false)\\)`))?.[0] ?? "";
      expect(definition).toContain(`${defaultValue},`);
      expect(definition.endsWith(`, ${memberVisible})`)).toBe(true);
      expect(catalogue.en[`settings.def.${key}.label`]).toBeTruthy();
      expect(catalogue.es[`settings.def.${key}.description`]).toBeTruthy();
    }
    expect(migration).toContain("on conflict (key) do nothing;");
  });

  it("enforces the switch, blocked screens, thresholds, session, cooldown, weekly target and sampling on the server", () => {
    const evaluate = migration.slice(
      migration.indexOf("create function public.evaluate_contextual_pulse_in_context"),
      migration.indexOf("revoke all on function public.evaluate_contextual_pulse_in_context"),
    );
    expect(evaluate).toContain("private.current_member_organization()");
    expect(evaluate).toContain("private.mfa_satisfied()");
    expect(evaluate).toContain("private.is_organization_member(org)");
    expect(evaluate).toContain("private.organization_feature_enabled(org, 'features.engagement_voice.contextual_pulses')");
    expect(evaluate).toContain("'blocked_context'");
    expect(evaluate).toMatch(/p_dwell_seconds < private\.organization_limit\(org, 'limits\.engagement_voice\.pulse_dwell_seconds'\)\s+and p_scroll_percent < /);
    expect(evaluate).toContain("seen.session_key = p_session_key");
    expect(evaluate).toContain("make_interval(hours => candidate.cooldown_hours)");
    expect(evaluate).toContain("answered.responded_at >= week_start");
    expect(evaluate).toContain(">= sampling_percent");
    expect(evaluate).not.toMatch(/p_organization_id|p_user_id/);
    expect(migration).toContain("grant execute on function public.evaluate_contextual_pulse_in_context(text, uuid, integer, integer) to authenticated;");
    expect(migration).toMatch(/before insert or update of event_key on public\.organization_pulse_prompts/);
  });
});
