// REQ-UG-AI-USAGE-DIGEST-20261001: the analytics Usage view's digest
// section. The presenter keeps nothing the database suppressed, the panel says
// plainly when a period is withheld, the Guide wording button appears only
// when the organization opted in, and the English and Spanish copy exists for
// every string and every switch definition.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsageDigestPanel } from "../src/features/analytics/ui/UsageDigestPanel.jsx";
import { normalizeUsageDigests } from "../src/features/analytics/usageDigest.js";
import { requestUsageDigestWording } from "../src/features/analytics/usageDigestApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

const SETTING_KEYS = [
  "features.analytics.ai_usage_digest",
  "features.analytics.ai_usage_digest_wording",
  "limits.analytics.ai_usage_digest_min_cohort",
];

function bucket(overrides = {}) {
  return {
    start: "2026-09-28",
    end: "2026-10-04",
    suppressed: false,
    minCohort: 25,
    actors: 30,
    checkins: 25,
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    enabled: true,
    minCohort: 25,
    digests: [{
      id: "00000000-0000-4000-8000-0000000000a1",
      period: "weekly",
      windowStart: "2026-09-07",
      windowEnd: "2026-10-04",
      generatedAt: "2026-10-05T13:05:00Z",
      hasData: true,
      buckets: [bucket({ start: "2026-09-21", end: "2026-09-27", actors: 25 }), bucket()],
      deltas: [{ metric: "actors", current: 30, previous: 25, direction: "up" }],
      ai: { status: "off", summary: null, model: null, enrichedAt: null },
      ...overrides,
    }],
  };
}

describe("usage digest normalization", () => {
  it("keeps the floored figures and drops anything the payload invented", () => {
    const { enabled, minCohort, digests } = normalizeUsageDigests(payload());
    expect(enabled).toBe(true);
    expect(minCohort).toBe(25);
    expect(digests).toHaveLength(1);
    expect(digests[0].latest).toEqual({ start: "2026-09-28", end: "2026-10-04", suppressed: false, minCohort: 25, actors: 30, checkins: 25 });
    expect(digests[0].deltas).toEqual([{ metric: "actors", current: 30, previous: 25, direction: "up" }]);
  });

  it("carries no view total, section or role row even when a stale payload has one", () => {
    const input = payload();
    input.digests[0].buckets = [bucket({ views: 170, topSections: [{ key: "/m/home", views: 140 }], byHat: [{ key: "member", views: 140 }], suppressedSections: 2 })];
    input.digests[0].deltas = [{ metric: "views", current: 170, previous: 150, direction: "up" }];
    const { digests } = normalizeUsageDigests(input);
    expect(Object.keys(digests[0].latest).sort()).toEqual(["actors", "checkins", "end", "minCohort", "start", "suppressed"]);
    expect(digests[0].deltas).toEqual([]);
  });

  it("reports no figures and no comparison for a suppressed period", () => {
    const input = payload();
    input.digests[0].buckets = [bucket({ suppressed: true, actors: null, checkins: null })];
    input.digests[0].deltas = [{ metric: "actors", current: null, previous: 30, direction: "down" }];
    const { digests } = normalizeUsageDigests(input);
    expect(digests[0].latest).toMatchObject({ suppressed: true, actors: null, checkins: null });
    expect(digests[0].hasData).toBe(false);
    expect(digests[0].deltas[0].direction).toBe("unknown");
  });

  it("drops an unknown period, an unknown metric and a negative count", () => {
    const { digests } = normalizeUsageDigests({
      enabled: true,
      minCohort: 25,
      digests: [
        { period: "daily", buckets: [] },
        { period: "monthly", buckets: [bucket({ actors: -4 })], deltas: [{ metric: "secrets", current: 1, previous: 1, direction: "up" }], ai: {} },
      ],
    });
    expect(digests).toHaveLength(1);
    expect(digests[0].period).toBe("monthly");
    expect(digests[0].latest.actors).toBe(null);
    expect(digests[0].deltas).toEqual([]);
  });

  it("treats a switched-off organization as no digests at all", () => {
    expect(normalizeUsageDigests({ enabled: false, digests: [{ period: "weekly", buckets: [bucket()] }] }))
      .toEqual({ enabled: false, minCohort: 25, digests: [] });
  });
});

describe("usage digest panel", () => {
  const panel = (props) => render(<LanguageProvider lang="en"><UsageDigestPanel {...props} /></LanguageProvider>);

  it("renders nothing without a loader", () => {
    const { container } = panel({});
    expect(container.querySelector("[data-usage-digest]")).toBeNull();
  });

  it("shows the stored weekly figures and no page-view total", async () => {
    panel({ load: () => Promise.resolve(payload()) });
    await screen.findByText("Weekly");
    expect(screen.getByText("30")).toBeTruthy();
    expect(screen.getByText("25")).toBeTruthy();
    expect(screen.queryByText("Page views")).toBeNull();
    expect(screen.queryByText(/check-ins stay hidden/)).toBeNull();
    expect(screen.getByText(/up from the period before/)).toBeTruthy();
    expect(screen.getByText("Sep 28, 2026 – Oct 4, 2026")).toBeTruthy();
    expect(screen.queryByText("Sep 7, 2026 – Oct 4, 2026")).toBeNull();
  });

  it("says a period is withheld instead of showing a figure", async () => {
    const input = payload();
    input.digests[0].buckets = [bucket({ suppressed: true, minCohort: 60, actors: null, checkins: null })];
    panel({ load: () => Promise.resolve(input) });
    await screen.findByText("Hidden until at least 60 people have used the app in this period.");
    expect(screen.queryByText("30")).toBeNull();
  });

  it("says check-ins are withheld when too few people checked in", async () => {
    const input = payload();
    input.digests[0].buckets = [bucket({ checkins: null })];
    panel({ load: () => Promise.resolve(input) });
    await screen.findByText("Meeting check-ins stay hidden until at least 25 people have checked in.");
    expect(screen.getByText("30")).toBeTruthy();
  });

  it("tells staff when an admin has not turned the digest on", async () => {
    panel({ load: () => Promise.resolve({ enabled: false, digests: [] }) });
    await screen.findByText("An admin has not turned the usage digest on for this organization.");
  });

  it("hides wording when a stale available response has no publishable data", async () => {
    const input = payload({ hasData: false, ai: { status: "available" } });
    input.digests[0].buckets = [bucket({ suppressed: true, actors: null, checkins: null })];
    const onRequestWording = vi.fn();
    panel({ load: () => Promise.resolve(input), onRequestWording });
    await screen.findByText("Weekly");
    expect(screen.queryByRole("button", { name: "Ask the Guide to word this digest" })).toBeNull();
    expect(onRequestWording).not.toHaveBeenCalled();
  });

  it("offers Guide wording only when the organization opted in, and reloads after it saves", async () => {
    const off = panel({ load: () => Promise.resolve(payload()), onRequestWording: vi.fn() });
    await screen.findByText("Weekly");
    expect(screen.queryByText("Ask the Guide to word this digest")).toBeNull();
    off.unmount();

    const available = payload({ ai: { status: "available", summary: null, model: null, enrichedAt: null } });
    const worded = payload({
      ai: {
        status: "enriched",
        summary: { summary: "App use held steady.", highlights: ["Home stayed busiest"], caution: null },
        model: "union-ground/compass-mesh:v1",
        enrichedAt: "2026-10-05T14:00:00Z",
      },
    });
    const onRequestWording = vi.fn(async () => worded);
    panel({ load: () => Promise.resolve(available), onRequestWording });
    const button = await screen.findByText("Ask the Guide to word this digest");
    fireEvent.click(button);
    await waitFor(() => expect(onRequestWording).toHaveBeenCalledWith({
      digestId: "00000000-0000-4000-8000-0000000000a1",
      period: "weekly",
    }));
    await screen.findByText("App use held steady.");
    expect(screen.getByText("The Guide wrote this from the stored totals above. No individual activity was sent.")).toBeTruthy();
  });

  it("says so when the read fails", async () => {
    panel({ load: () => Promise.reject(new Error("nope")) });
    await screen.findByText("The usage digest could not be read right now.");
  });
});

describe("the governed wording call", () => {
  it("posts the usage_digest mode with the hat and the digest id only", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ digest: { id: "d" } }) }));
    await requestUsageDigestWording({ access_token: "token" }, "admin", "00000000-0000-4000-8000-0000000000a1", fetcher);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("/api/guide");
    expect(JSON.parse(options.body)).toEqual({
      mode: "usage_digest",
      hat: "admin",
      digestId: "00000000-0000-4000-8000-0000000000a1",
    });
  });

  it("refuses without a session and surfaces the server code", async () => {
    await expect(requestUsageDigestWording(null, "admin", "x", vi.fn())).rejects.toMatchObject({ status: 401 });
    const fetcher = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ code: "digest_summary_unavailable", error: "no" }) }));
    await expect(requestUsageDigestWording({ access_token: "t" }, "admin", "x", fetcher))
      .rejects.toMatchObject({ status: 409, code: "digest_summary_unavailable" });
  });
});

describe("usage digest copy", () => {
  it("ships English and Spanish for every panel string and every switch definition", () => {
    const keys = Object.keys(catalogue.en).filter((key) => key.startsWith("usageDigest."));
    expect(keys.length).toBeGreaterThan(15);
    for (const key of keys) expect(catalogue.es[key], `es ${key}`).toBeTruthy();
    for (const key of SETTING_KEYS) {
      for (const lang of ["en", "es"]) {
        expect(catalogue[lang][`settings.def.${key}.label`], `${lang} ${key} label`).toBeTruthy();
        expect(catalogue[lang][`settings.def.${key}.description`], `${lang} ${key} description`).toBeTruthy();
      }
    }
  });
});
